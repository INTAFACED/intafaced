/**
 * Support-assisted recovery (I-signin-sessions-24; J-identity-05 #5, J-identity-19 #1-#3). A person who cannot sign in, and
 * has no recovery code and no other way in, asks Support.
 *
 * - An operator opens a case for the account: it shows the masked proved address and the account's live sessions, and no
 *   link exists yet. Every door needs `admin:write` with a second factor on a live session, and every read of a case is
 *   in the operator read audit (`session_list`). The same request id answers the same case. One open case per account.
 * - A different operator approves it: a four-eyes `identity.support_recovery_link` approval filed at svc-identity against
 *   the account, over the case id (`approvalProposal`). The opener then sends the link, which spends that approval in the
 *   same transaction. The approver must be someone else, and neither may be the account itself.
 * - The link goes only to the account's own proved address, by the mail outbox. Its token is 32 random bytes; the case
 *   keeps only an HMAC of it under the flow key, and no answer of any door carries it, so no operator ever sees it. It
 *   lives for the owner's IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS; unset refuses before anything is spent.
 * - The link works once. Using it removes the authenticator app and its recovery codes, stops a waiting second-step reset,
 *   forgets every trusted device, ends every session and revokes every API key, in one transaction, then mails the
 *   "recovered through Support" notice. The person signs in with the password and sets up a new app. A wrong, used,
 *   cancelled or expired link is one refusal.
 * - The customer security lock refuses the send and the use: nothing is recovered while the lock holds.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { transaction } from '@intafaced/db';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import type { Context } from '@intafaced/contracts';
import type { SupportRecoveryCase } from '@intafaced/contracts/identity';
import type { Sql } from 'postgres';
import { syncNavigatorSessionClosed } from '../agents/navigator-session-projection-sync.js';
import { maskEmail } from '../ops/account-directory.js';
import { sqlCasConsume, sqlGetApprovalForUpdate } from './action-approval-store.js';
import { queueFactorChangedNotice } from './factor-changed-notice.js';
import { queueMail } from './mfa-reset.js';
import type { PasswordResetMail } from './password-reset.js';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';
import { assertNotSecurityLocked } from './security-lock.js';

export const SUPPORT_RECOVERY_ACTION_TYPE = 'identity.support_recovery_link';
export const SUPPORT_RECOVERY_TARGET_SERVICE = 'svc-identity';
export const SUPPORT_RECOVERY_VERSION = '1';

/** One day. Longer than that is not a mailed link. */
const MAX_LINK_TTL_SECONDS = 86_400;
/** The live sessions a case shows. */
const CASE_SESSIONS_LIMIT = 20;

export type SupportRecoveryErrorCode =
  | 'operator.denied'
  | 'mfa.required'
  | 'identity.support_recovery_not_found'
  | 'identity.support_recovery_self'
  | 'identity.support_recovery_account_inactive'
  | 'identity.support_recovery_no_proved_address'
  | 'identity.support_recovery_request_reused'
  | 'identity.support_recovery_not_open'
  | 'identity.support_recovery_approval_required'
  | 'identity.support_recovery_link_invalid'
  | 'identity.support_recovery_unconfigured'
  | 'auth.codes_unwired'
  | 'vendor.email';

export class SupportRecoveryError extends Error {
  constructor(readonly code: SupportRecoveryErrorCode) {
    super(code);
    this.name = 'SupportRecoveryError';
  }
}

export interface SupportRecoveryDeps {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  /** IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS. Unset refuses the send. */
  readonly linkTtlSeconds: number | undefined;
  /** The flow HMAC key. Unset refuses the send and the use. */
  readonly subjectKey: string | undefined;
  readonly now: () => Date;
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

export type SupportRecoveryState = 'open' | 'link_sent' | 'used' | 'cancelled' | 'expired';

/** What an operator sees (contracts `supportRecoveryCaseSchema`). Never the token, its hash or the full address. */
export type SupportRecoveryCaseView = SupportRecoveryCase;

/** Bound to the account and the case. */
export function supportRecoveryPayloadHash(userId: string, caseId: string): string {
  return founderChangeHash({ userId: userId.toLowerCase(), caseId: caseId.toLowerCase() }, SUPPORT_RECOVERY_VERSION);
}

type Operator = { readonly userId: string; readonly sessionId: string };

/** The same operator notion as operator-sessions.ts (`admin:write`, a second factor), refusing with this flow's own codes. */
function requireOperator(context: Context): Operator {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:write')) {
    throw new SupportRecoveryError('operator.denied');
  }
  if (principal.mfa !== true) throw new SupportRecoveryError('mfa.required');
  return { userId: principal.userId.toLowerCase(), sessionId: principal.sid };
}

/** The operator's own session must still be live and carry its second factor, read in the transaction that acts. */
async function lockOperatorSession(tx: Sql, actor: Operator, now: Date): Promise<void> {
  const [session] = await tx<Array<{ revoked: boolean; mfa: boolean; expires_at: Date }>>`
    SELECT revoked, mfa, expires_at FROM sessions WHERE id = ${actor.sessionId} AND user_id = ${actor.userId} FOR UPDATE`;
  if (!session || session.revoked || session.expires_at.getTime() <= now.getTime()) throw new SupportRecoveryError('operator.denied');
  if (!session.mfa) throw new SupportRecoveryError('mfa.required');
}

function tokenHash(key: string, token: string): string {
  return createHmac('sha256', key).update(`support-recovery:${token}`).digest('hex');
}

function usableKey(deps: SupportRecoveryDeps): string | undefined {
  return deps.subjectKey && deps.subjectKey.length >= 32 ? deps.subjectKey : undefined;
}

type CaseRow = {
  id: string;
  user_id: string;
  state: SupportRecoveryState;
  reason: string;
  opened_by: string;
  open_request_id: string;
  approved_by: string | null;
  link_sent_at: Date | null;
  link_expires_at: Date | null;
  used_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  expired: boolean;
};

const CASE_COLUMNS = `id, user_id, state, reason, opened_by, open_request_id, approved_by, link_sent_at, link_expires_at, used_at,
  closed_at, created_at, (state = 'link_sent' AND link_expires_at <= clock_timestamp()) AS expired`;

type AccountRow = { handle: string; status: string; email: string | null; email_verified_at: Date | null };

/** The case as the operator sees it. It lists the account's sessions, so it is written to the operator read audit. */
async function caseView(tx: Sql, row: CaseRow, actor: Operator): Promise<SupportRecoveryCaseView> {
  await tx`
    INSERT INTO operator_read_audit (audit_id, actor_id, kind, query_hash)
    VALUES (${randomUUID()}, ${actor.userId}, 'session_list', ${createHash('sha256').update(row.user_id).digest('hex')})`;
  const [account] = await tx<AccountRow[]>`SELECT handle, status, email, email_verified_at FROM users WHERE id = ${row.user_id}`;
  const sessions = await tx<Array<{ device: string | null; created_at: Date; last_used_at: Date }>>`
    SELECT device, created_at, last_used_at FROM sessions
    WHERE user_id = ${row.user_id} AND revoked = false AND expires_at > now()
    ORDER BY last_used_at DESC, id DESC LIMIT ${CASE_SESSIONS_LIMIT}`;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    caseId: row.id,
    userId: row.user_id,
    handle: account?.handle ?? '',
    // A sent link past its lifetime reads as expired; the row itself is closed when the next case opens.
    state: row.expired ? 'expired' : row.state,
    reason: row.reason,
    openedBy: row.opened_by,
    openedAt: row.created_at.toISOString(),
    approvedBy: row.approved_by,
    linkSentAt: iso(row.link_sent_at),
    linkExpiresAt: iso(row.link_expires_at),
    usedAt: iso(row.used_at),
    closedAt: iso(row.closed_at),
    contact: {
      email: account?.email ? maskEmail(account.email) : null,
      emailProved: Boolean(account?.email && account.email_verified_at),
    },
    sessions: sessions.map((s) => ({ deviceLabel: s.device, created: s.created_at.toISOString(), lastSeen: s.last_used_at.toISOString() })),
    approvalProposal: {
      actionType: SUPPORT_RECOVERY_ACTION_TYPE,
      targetService: SUPPORT_RECOVERY_TARGET_SERVICE,
      targetId: row.user_id,
      expectedVersion: SUPPORT_RECOVERY_VERSION,
      payloadHash: supportRecoveryPayloadHash(row.user_id, row.id),
    },
  };
}

async function lockCase(tx: Sql, caseId: string): Promise<CaseRow | undefined> {
  const [row] = await tx<CaseRow[]>`SELECT ${tx.unsafe(CASE_COLUMNS)} FROM support_recovery_cases WHERE id = ${caseId} FOR UPDATE`;
  return row;
}

/**
 * Open a case for one account (J-identity-19 #1). The account must exist, be active and have a proved address to send the
 * link to; an operator cannot open one for their own account. An open case for the account answers instead of a second
 * one; a sent link past its lifetime is closed first. The same request id with a different account or reason is refused.
 */
export async function openSupportRecoveryCase(
  deps: SupportRecoveryDeps,
  context: Context,
  input: { userId: string; reason: string; requestId: string },
): Promise<SupportRecoveryCaseView> {
  const actor = requireOperator(context);
  const userId = input.userId.trim().toLowerCase();
  const reason = input.reason.trim();
  const requestId = input.requestId.trim();
  if (userId === actor.userId) throw new SupportRecoveryError('identity.support_recovery_self');
  return transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    const [prior] = await tx<CaseRow[]>`
      SELECT ${tx.unsafe(CASE_COLUMNS)} FROM support_recovery_cases WHERE opened_by = ${actor.userId} AND open_request_id = ${requestId}`;
    if (prior) {
      if (prior.user_id !== userId || prior.reason !== reason) throw new SupportRecoveryError('identity.support_recovery_request_reused');
      return caseView(tx, prior, actor);
    }
    const [account] = await tx<AccountRow[]>`SELECT handle, status, email, email_verified_at FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!account) throw new SupportRecoveryError('identity.support_recovery_not_found');
    if (account.status !== 'active') throw new SupportRecoveryError('identity.support_recovery_account_inactive');
    if (!account.email || !account.email_verified_at) throw new SupportRecoveryError('identity.support_recovery_no_proved_address');
    await tx`UPDATE support_recovery_cases SET state = 'expired', updated_at = clock_timestamp()
      WHERE user_id = ${userId} AND state = 'link_sent' AND link_expires_at <= clock_timestamp()`;
    const [open] = await tx<CaseRow[]>`
      SELECT ${tx.unsafe(CASE_COLUMNS)} FROM support_recovery_cases WHERE user_id = ${userId} AND state IN ('open', 'link_sent')`;
    if (open) return caseView(tx, open, actor);
    const [row] = await tx<CaseRow[]>`
      INSERT INTO support_recovery_cases (user_id, state, reason, opened_by, open_request_id)
      VALUES (${userId}, 'open', ${reason}, ${actor.userId}, ${requestId})
      RETURNING ${tx.unsafe(CASE_COLUMNS)}`;
    return caseView(tx, row!, actor);
  });
}

/** One case, for an operator watching it (J-identity-19 #3). */
export async function readSupportRecoveryCase(
  deps: SupportRecoveryDeps,
  context: Context,
  caseId: string,
): Promise<SupportRecoveryCaseView> {
  const actor = requireOperator(context);
  return transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    const [row] = await tx<CaseRow[]>`SELECT ${tx.unsafe(CASE_COLUMNS)} FROM support_recovery_cases WHERE id = ${caseId}`;
    if (!row) throw new SupportRecoveryError('identity.support_recovery_not_found');
    return caseView(tx, row, actor);
  });
}

/**
 * Send the one-time link (J-identity-19 #2/#3). Only the operator who opened the case sends it, and only with an approved,
 * unexpired, unspent `identity.support_recovery_link` approval for this account and case that a different person approved;
 * it is spent here. Sending again answers the case as it stands and sends nothing more.
 */
export async function sendSupportRecoveryLink(
  deps: SupportRecoveryDeps,
  context: Context,
  input: { caseId: string; approvalId: string },
): Promise<SupportRecoveryCaseView> {
  const actor = requireOperator(context);
  const ttl = deps.linkTtlSeconds;
  const key = usableKey(deps);
  // Blank settings refuse before the approval is spent.
  if (ttl === undefined || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_LINK_TTL_SECONDS) {
    throw new SupportRecoveryError('identity.support_recovery_unconfigured');
  }
  if (key === undefined) throw new SupportRecoveryError('auth.codes_unwired');
  if (!deps.mail) throw new SupportRecoveryError('vendor.email');
  const approvalId = input.approvalId.trim();
  const view = await transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    // The account row first, then the case, in the order open and redeem take them.
    const [named] = await tx<Array<{ user_id: string }>>`SELECT user_id FROM support_recovery_cases WHERE id = ${input.caseId}`;
    if (!named) throw new SupportRecoveryError('identity.support_recovery_not_found');
    const [account] = await tx<
      AccountRow[]
    >`SELECT handle, status, email, email_verified_at FROM users WHERE id = ${named.user_id} FOR UPDATE`;
    const row = await lockCase(tx, input.caseId);
    if (!row) throw new SupportRecoveryError('identity.support_recovery_not_found');
    if (row.opened_by !== actor.userId) throw new SupportRecoveryError('operator.denied');
    if (row.state === 'link_sent' && !row.expired) return caseView(tx, row, actor);
    if (row.state !== 'open') throw new SupportRecoveryError('identity.support_recovery_not_open');
    if (!account || account.status !== 'active') throw new SupportRecoveryError('identity.support_recovery_account_inactive');
    if (!account.email || !account.email_verified_at) throw new SupportRecoveryError('identity.support_recovery_no_proved_address');
    await assertNotSecurityLocked(tx, row.user_id);

    const now = deps.now();
    const approval = await sqlGetApprovalForUpdate(tx, approvalId);
    const requester = approval?.requesterId.toLowerCase();
    const approver = approval?.approverId?.toLowerCase() ?? null;
    const bound =
      approval !== null &&
      approval.status === 'APPROVED' &&
      approval.kind !== 'same_person' &&
      approval.actionType === SUPPORT_RECOVERY_ACTION_TYPE &&
      approval.targetService === SUPPORT_RECOVERY_TARGET_SERVICE &&
      approval.targetId.toLowerCase() === row.user_id &&
      approval.expectedVersion === SUPPORT_RECOVERY_VERSION &&
      approval.payloadHash === supportRecoveryPayloadHash(row.user_id, row.id) &&
      requester === actor.userId &&
      approver !== null &&
      approver !== requester &&
      approver !== row.user_id &&
      approval.expiresAt.getTime() > now.getTime();
    if (!bound || approval === null || approver === null) throw new SupportRecoveryError('identity.support_recovery_approval_required');
    const consumed = await sqlCasConsume(tx, {
      approvalId: approval.approvalId,
      operationId: approval.operationId,
      payloadHash: approval.payloadHash,
      targetService: approval.targetService,
      targetId: approval.targetId,
      expectedVersion: approval.expectedVersion,
      now,
      requestId: `support-recovery:${row.id}`,
      consumedByService: SUPPORT_RECOVERY_TARGET_SERVICE,
      consumedByPrincipal: actor.userId,
    });
    if (!consumed) throw new SupportRecoveryError('identity.support_recovery_approval_required');

    const token = randomBytes(32).toString('base64url');
    const [sent] = await tx<CaseRow[]>`
      UPDATE support_recovery_cases
      SET state = 'link_sent', approval_id = ${approval.approvalId}, approved_by = ${approver}, token_hash = ${tokenHash(key, token)},
        link_sent_at = clock_timestamp(), link_expires_at = clock_timestamp() + make_interval(secs => ${ttl}),
        updated_at = clock_timestamp()
      WHERE id = ${row.id}
      RETURNING ${tx.unsafe(CASE_COLUMNS)}`;
    await queueMail(tx, {
      userId: row.user_id,
      key: `support-recovery:${row.id}`,
      purpose: 'support-recovery',
      recipient: account.email,
      code: token,
      expiresAt: sent!.link_expires_at!,
      now,
    });
    return caseView(tx, sent!, actor);
  });
  await deps.afterCommit?.();
  return view;
}

/** Close a case that has not been used (J-identity-19): an unsent case, or a sent link, which then stops working. */
export async function cancelSupportRecoveryCase(
  deps: SupportRecoveryDeps,
  context: Context,
  caseId: string,
): Promise<SupportRecoveryCaseView> {
  const actor = requireOperator(context);
  return transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    const row = await lockCase(tx, caseId);
    if (!row) throw new SupportRecoveryError('identity.support_recovery_not_found');
    if (row.state !== 'open' && row.state !== 'link_sent') return caseView(tx, row, actor);
    const [closed] = await tx<CaseRow[]>`
      UPDATE support_recovery_cases SET state = 'cancelled', closed_by = ${actor.userId}, closed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = ${row.id} RETURNING ${tx.unsafe(CASE_COLUMNS)}`;
    return caseView(tx, closed!, actor);
  });
}

/**
 * The person opens the mailed link and confirms (J-identity-05 #5). Works once, before the link's lifetime ends, on an
 * active account whose lock does not hold. Removes the authenticator app and its recovery codes, stops a waiting
 * second-step reset, forgets every trusted device, ends every session, revokes every API key and mails the notice, in one
 * transaction. Answers nothing about the account.
 */
export async function redeemSupportRecoveryLink(deps: SupportRecoveryDeps, input: { token: string }): Promise<{ recovered: true }> {
  const key = usableKey(deps);
  if (key === undefined) throw new SupportRecoveryError('auth.codes_unwired');
  const token = input.token.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SupportRecoveryError('identity.support_recovery_link_invalid');
  const hash = tokenHash(key, token);
  const ended = await transaction(deps.sql, async (tx) => {
    const [found] = await tx<Array<{ user_id: string }>>`SELECT user_id FROM support_recovery_cases WHERE token_hash = ${hash}`;
    if (!found) throw new SupportRecoveryError('identity.support_recovery_link_invalid');
    // The account row first, then the case, in the order every other writer of the account takes them.
    const [account] = await tx<Array<AccountRow & { totp: boolean }>>`
      SELECT handle, status, email, email_verified_at, totp_secret IS NOT NULL AS totp FROM users WHERE id = ${found.user_id} FOR UPDATE`;
    const [row] = await tx<CaseRow[]>`
      SELECT ${tx.unsafe(CASE_COLUMNS)} FROM support_recovery_cases WHERE token_hash = ${hash} FOR UPDATE`;
    if (!row || row.state !== 'link_sent' || row.expired) throw new SupportRecoveryError('identity.support_recovery_link_invalid');
    if (!account || account.status !== 'active') throw new SupportRecoveryError('identity.support_recovery_link_invalid');
    await assertNotSecurityLocked(tx, row.user_id);

    await tx`UPDATE support_recovery_cases SET state = 'used', used_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${row.id}`;
    await tx`UPDATE users SET totp_secret = NULL, totp_label = NULL, totp_enrolled_at = NULL, totp_last_step = NULL,
      recovery_code_hashes = '[]'::jsonb, updated_at = now() WHERE id = ${row.user_id}`;
    await tx`UPDATE mfa_resets SET state = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE user_id = ${row.user_id} AND state IN ('code_sent', 'waiting')`;
    // The lost phone is trusted no longer, as when the app is replaced (totp-lifecycle.ts).
    await tx`UPDATE trusted_devices SET removed_at = now() WHERE user_id = ${row.user_id} AND removed_at IS NULL`;
    const sessions = await tx<Array<{ id: string }>>`
      UPDATE sessions SET revoked = true WHERE user_id = ${row.user_id} AND revoked = false RETURNING id`;
    await revokeAllApiKeys(tx, row.user_id, row.user_id, 'support');
    const now = deps.now();
    // The inbox hears the app went (I-signin-sessions-08); the mail is the recovered-through-Support notice below.
    if (account.totp) await queueFactorChangedNotice(tx, { userId: row.user_id, change: 'totp_removed', now, mail: false });
    if (account.email && account.email_verified_at) {
      await queueMail(tx, {
        userId: row.user_id,
        key: `support-recovery-used:${row.id}`,
        purpose: 'support-recovery-used',
        recipient: account.email,
        code: null,
        expiresAt: now,
        now,
      });
    }
    return sessions.map((session) => session.id);
  });
  // The navigator's projection of each ended session closes after the commit, best effort, as other session ends do.
  for (const sessionId of ended) await syncNavigatorSessionClosed(deps.sql, sessionId);
  await deps.afterCommit?.();
  return { recovered: true };
}
