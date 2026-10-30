/**
 * Death notices (RC-identity-02, J-identity-05 #7) and the recovery claim check (RC-identity-08).
 *
 * - Staff with `admin:compliance` and a second factor on a live session record a notice that an account holder has
 *   died. Recording changes nothing on the account: a false report must never lock a living person. The same case
 *   reference for the same account is one notice. Nobody records a notice for their own account.
 * - A received notice is rejected by one person (it changes nothing), or confirmed with a four-eyes
 *   `identity.death_notice_confirm` approval filed at svc-identity against the account, over the notice id
 *   (`approvalProposal`). The person confirming is the requester; the approver is someone else, and neither is the
 *   account. Confirming freezes the account and revokes its sessions, API keys and sub-accounts in the same
 *   transaction, as the founder freeze does. One confirmed notice per account.
 * - Each notice is published twice from its own row, `identity.death_notice.created` and, once confirmed,
 *   `identity.death_notice.confirmed`, at least once, with the business key `identity.death_notice.<verb>:<noticeId>`.
 * - `verifyRecoveryClaim` is what svc-bank asks before it sweeps the trading balances to the heir: under the account's
 *   row lock, the account is still in the freeze its confirmed notice made (no restore, freeze or closure since: the
 *   account's control version is the one the confirmation left), the heir is the one the owner named and still active, a
 *   threshold is set, and at least that many distinct live keys the owner added signed this claim. A heir, threshold or
 *   key set after the notice was recorded does not count: by then the change may be anyone's doing. Anything else is
 *   one typed refusal, and nothing here moves value.
 */
import { createPublicKey, verify } from 'node:crypto';
import { transaction } from '@intafaced/db';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import type { Context } from '@intafaced/contracts';
import {
  DEATH_NOTICE_CONFIRM_ACTION_TYPE,
  DEATH_NOTICE_TARGET_SERVICE,
  DEATH_NOTICE_VERSION,
  recoveryClaimMessage,
  type DeathNoticeView,
  type RecoveryClaimRefusal,
  type RecoveryClaimVerdict,
  type RecoveryClaimVerifyRequest,
  type RecoveryEstate,
} from '@intafaced/contracts/identity-recovery';
import type { EventBus } from '@intafaced/events';
import type { Sql } from 'postgres';
import { sqlCasConsume, sqlGetApprovalForUpdate } from './action-approval-store.js';
import { fingerprintOf } from './recovery-keys.js';

export type DeathNoticeErrorCode =
  | 'operator.denied'
  | 'mfa.required'
  | 'identity.death_notice_not_found'
  | 'identity.death_notice_self'
  | 'identity.death_notice_account_closed'
  | 'identity.death_notice_case_reused'
  | 'identity.death_notice_not_open'
  | 'identity.death_notice_already_confirmed'
  | 'identity.death_notice_approval_required';

export class DeathNoticeError extends Error {
  constructor(readonly code: DeathNoticeErrorCode) {
    super(code);
    this.name = 'DeathNoticeError';
  }
}

export interface DeathNoticeDeps {
  readonly sql: Sql;
  readonly now: () => Date;
}

/** Bound to the account and the notice. */
export function deathNoticePayloadHash(userId: string, noticeId: string): string {
  return founderChangeHash({ userId: userId.toLowerCase(), noticeId: noticeId.toLowerCase() }, DEATH_NOTICE_VERSION);
}

type Operator = { readonly userId: string; readonly sessionId: string };

/** `admin:compliance` with a second factor, on a person's own session: no API key, sub-account or service. */
function requireOperator(context: Context): Operator {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:compliance')) {
    throw new DeathNoticeError('operator.denied');
  }
  if (principal.mfa !== true) throw new DeathNoticeError('mfa.required');
  return { userId: principal.userId.toLowerCase(), sessionId: principal.sid };
}

/** The operator's own session must still be live and carry its second factor, read in the transaction that acts. */
async function lockOperatorSession(tx: Sql, actor: Operator, now: Date): Promise<void> {
  const [session] = await tx<Array<{ revoked: boolean; mfa: boolean; expires_at: Date }>>`
    SELECT revoked, mfa, expires_at FROM sessions WHERE id = ${actor.sessionId} AND user_id = ${actor.userId} FOR UPDATE`;
  if (!session || session.revoked || session.expires_at.getTime() <= now.getTime()) throw new DeathNoticeError('operator.denied');
  if (!session.mfa) throw new DeathNoticeError('mfa.required');
}

type NoticeRow = {
  id: string;
  subject_user_id: string;
  case_ref: string;
  status: DeathNoticeView['status'];
  reporter_kind: DeathNoticeView['reporterKind'];
  evidence_document_ids: string[];
  recorded_by: string;
  received_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  approved_by: string | null;
};

const NOTICE_COLUMNS = `id, subject_user_id, case_ref, status, reporter_kind, evidence_document_ids, recorded_by, received_at,
  decided_at, decided_by, approved_by`;

function noticeView(row: NoticeRow): DeathNoticeView {
  return {
    noticeId: row.id,
    userId: row.subject_user_id,
    caseRef: row.case_ref,
    status: row.status,
    reporterKind: row.reporter_kind,
    evidenceDocumentIds: [...row.evidence_document_ids],
    recordedBy: row.recorded_by,
    receivedAt: row.received_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decidedBy: row.decided_by,
    approvedBy: row.approved_by,
    approvalProposal: {
      actionType: DEATH_NOTICE_CONFIRM_ACTION_TYPE,
      targetService: DEATH_NOTICE_TARGET_SERVICE,
      targetId: row.subject_user_id,
      expectedVersion: DEATH_NOTICE_VERSION,
      payloadHash: deathNoticePayloadHash(row.subject_user_id, row.id),
    },
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((id) => left.has(id));
}

/**
 * Record a notice (RC-identity-02). The account must exist and not be closed. The same case reference for the same
 * account answers the notice already recorded; with another reporter or other evidence it is refused.
 */
export async function recordDeathNotice(
  deps: DeathNoticeDeps,
  context: Context,
  input: {
    userId: string;
    caseRef: string;
    reporterKind: DeathNoticeView['reporterKind'];
    evidenceDocumentIds: readonly string[];
    receivedAt: string;
  },
): Promise<DeathNoticeView> {
  const actor = requireOperator(context);
  const userId = input.userId.trim().toLowerCase();
  const caseRef = input.caseRef.trim();
  const evidence = [...new Set(input.evidenceDocumentIds.map((id) => id.toLowerCase()))];
  if (userId === actor.userId) throw new DeathNoticeError('identity.death_notice_self');
  return transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    const [account] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!account) throw new DeathNoticeError('identity.death_notice_not_found');
    const [prior] = await tx<NoticeRow[]>`
      SELECT ${tx.unsafe(NOTICE_COLUMNS)} FROM death_notices WHERE subject_user_id = ${userId} AND case_ref = ${caseRef}`;
    if (prior) {
      if (prior.reporter_kind !== input.reporterKind || !sameIds(prior.evidence_document_ids, evidence)) {
        throw new DeathNoticeError('identity.death_notice_case_reused');
      }
      return noticeView(prior);
    }
    // A closed record is read-only, as for every other writer of the account (an archived one is closed: users_archive_ck).
    if (account.status === 'closed') throw new DeathNoticeError('identity.death_notice_account_closed');
    const [row] = await tx<NoticeRow[]>`
      INSERT INTO death_notices (subject_user_id, case_ref, reporter_kind, evidence_document_ids, recorded_by, received_at)
      VALUES (${userId}, ${caseRef}, ${input.reporterKind}, ${evidence}::uuid[], ${actor.userId}, ${input.receivedAt})
      RETURNING ${tx.unsafe(NOTICE_COLUMNS)}`;
    return noticeView(row!);
  });
}

/** The notices of one account, newest first. */
export async function listDeathNotices(deps: DeathNoticeDeps, context: Context, userId: string): Promise<DeathNoticeView[]> {
  const actor = requireOperator(context);
  return transaction(
    deps.sql,
    async (tx) => {
      await lockOperatorSession(tx, actor, deps.now());
      const rows = await tx<NoticeRow[]>`
      SELECT ${tx.unsafe(NOTICE_COLUMNS)} FROM death_notices WHERE subject_user_id = ${userId.toLowerCase()}
      ORDER BY created_at DESC, id DESC LIMIT 50`;
      return rows.map(noticeView);
    },
    { isolation: 'read committed' },
  );
}

/** The account row first, then the notice, in the order every writer of the account takes them. */
async function lockNotice(tx: Sql, noticeId: string): Promise<{ row: NoticeRow; status: string }> {
  const [named] = await tx<Array<{ subject_user_id: string }>>`SELECT subject_user_id FROM death_notices WHERE id = ${noticeId}`;
  if (!named) throw new DeathNoticeError('identity.death_notice_not_found');
  const [account] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${named.subject_user_id} FOR UPDATE`;
  const [row] = await tx<NoticeRow[]>`SELECT ${tx.unsafe(NOTICE_COLUMNS)} FROM death_notices WHERE id = ${noticeId} FOR UPDATE`;
  if (!row || !account) throw new DeathNoticeError('identity.death_notice_not_found');
  return { row, status: account.status };
}

/** A received notice found to be wrong. One person may reject it; it changes nothing on the account. */
export async function rejectDeathNotice(deps: DeathNoticeDeps, context: Context, noticeId: string): Promise<DeathNoticeView> {
  const actor = requireOperator(context);
  return transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    const { row } = await lockNotice(tx, noticeId);
    if (row.subject_user_id === actor.userId) throw new DeathNoticeError('identity.death_notice_self');
    if (row.status === 'rejected') return noticeView(row);
    if (row.status !== 'received') throw new DeathNoticeError('identity.death_notice_not_open');
    const [rejected] = await tx<NoticeRow[]>`
      UPDATE death_notices SET status = 'rejected', decided_at = clock_timestamp(), decided_by = ${actor.userId},
        updated_at = clock_timestamp()
      WHERE id = ${row.id} RETURNING ${tx.unsafe(NOTICE_COLUMNS)}`;
    return noticeView(rejected!);
  });
}

/**
 * Confirm a received notice. Only with an approved, unexpired, unspent `identity.death_notice_confirm` approval for
 * this account and notice, requested by the person confirming and approved by someone else; it is spent here. Then, in
 * the same transaction, the account is frozen and its sessions, API keys and sub-accounts revoked. Confirming again
 * answers the notice as it stands.
 */
export async function confirmDeathNotice(
  deps: DeathNoticeDeps,
  context: Context,
  input: { noticeId: string; approvalId: string },
): Promise<DeathNoticeView> {
  const actor = requireOperator(context);
  const approvalId = input.approvalId.trim();
  return transaction(deps.sql, async (tx) => {
    await lockOperatorSession(tx, actor, deps.now());
    const { row, status } = await lockNotice(tx, input.noticeId);
    if (row.subject_user_id === actor.userId) throw new DeathNoticeError('identity.death_notice_self');
    if (row.status === 'confirmed') return noticeView(row);
    if (row.status !== 'received') throw new DeathNoticeError('identity.death_notice_not_open');
    if (status === 'closed') throw new DeathNoticeError('identity.death_notice_account_closed');
    const [other] = await tx<Array<{ id: string }>>`
      SELECT id FROM death_notices WHERE subject_user_id = ${row.subject_user_id} AND status = 'confirmed'`;
    if (other) throw new DeathNoticeError('identity.death_notice_already_confirmed');

    const now = deps.now();
    const approval = await sqlGetApprovalForUpdate(tx, approvalId);
    const requester = approval?.requesterId.toLowerCase();
    const approver = approval?.approverId?.toLowerCase() ?? null;
    const bound =
      approval !== null &&
      approval.status === 'APPROVED' &&
      approval.kind !== 'same_person' &&
      approval.actionType === DEATH_NOTICE_CONFIRM_ACTION_TYPE &&
      approval.targetService === DEATH_NOTICE_TARGET_SERVICE &&
      approval.targetId.toLowerCase() === row.subject_user_id &&
      approval.expectedVersion === DEATH_NOTICE_VERSION &&
      approval.payloadHash === deathNoticePayloadHash(row.subject_user_id, row.id) &&
      requester === actor.userId &&
      approver !== null &&
      approver !== requester &&
      approver !== row.subject_user_id &&
      approval.expiresAt.getTime() > now.getTime();
    if (!bound || approval === null || approver === null) throw new DeathNoticeError('identity.death_notice_approval_required');
    const consumed = await sqlCasConsume(tx, {
      approvalId: approval.approvalId,
      operationId: approval.operationId,
      payloadHash: approval.payloadHash,
      targetService: approval.targetService,
      targetId: approval.targetId,
      expectedVersion: approval.expectedVersion,
      now,
      requestId: `death-notice:${row.id}`,
      consumedByService: DEATH_NOTICE_TARGET_SERVICE,
      consumedByPrincipal: actor.userId,
    });
    if (!consumed) throw new DeathNoticeError('identity.death_notice_approval_required');

    // The freeze, as the founder freeze takes it (founder-controls.ts `change`): nothing signs in or trades for the account.
    const [frozen] = await tx<Array<{ version: string }>>`
      UPDATE users SET status = 'frozen', identity_control_version = identity_control_version + 1, updated_at = now()
      WHERE id = ${row.subject_user_id} RETURNING identity_control_version::text AS version`;
    const [confirmed] = await tx<NoticeRow[]>`
      UPDATE death_notices SET status = 'confirmed', decided_at = clock_timestamp(), decided_by = ${actor.userId},
        approval_id = ${approval.approvalId}, approved_by = ${approver}, frozen_control_version = ${frozen!.version}::bigint,
        updated_at = clock_timestamp()
      WHERE id = ${row.id} RETURNING ${tx.unsafe(NOTICE_COLUMNS)}`;
    await tx`UPDATE sessions SET revoked = true WHERE user_id = ${row.subject_user_id} AND revoked = false`;
    await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze' WHERE user_id = ${row.subject_user_id} AND revoked = false`;
    await tx`UPDATE sub_accounts SET revoked = true WHERE parent_user_id = ${row.subject_user_id} AND revoked = false`;
    await tx`UPDATE navigator_session_projections SET status = 'closed', published_at = now()
      WHERE user_id = ${row.subject_user_id} AND status = 'open'`;
    return noticeView(confirmed!);
  });
}

export interface DeathNoticeRelayDeps {
  readonly sql: Sql;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly now: () => Date;
}

/**
 * Publish the notices not yet published, oldest first, one row per short transaction: `created` first, then
 * `confirmed` once the notice is confirmed. A row is claimed under SKIP LOCKED and marked only after its publish
 * returns, so a crash in between publishes again with the same business key and never loses it. The two events of one
 * notice keep their order; notices are of different accounts, so a row whose publish throws is left for the next run
 * and the others still go out. The first error is thrown once the run is over.
 */
export async function relayDeathNoticeEvents(deps: DeathNoticeRelayDeps, limit = 50): Promise<number> {
  const due = await deps.sql<Array<{ id: string }>>`
    SELECT id FROM death_notices
    WHERE created_published_at IS NULL OR (status = 'confirmed' AND confirmed_published_at IS NULL)
    ORDER BY created_at, id LIMIT ${limit}`;
  let published = 0;
  let failure: unknown;
  for (const { id } of due) {
    try {
      published += await relayOne(deps, id);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
  return published;
}

async function relayOne(deps: DeathNoticeRelayDeps, id: string): Promise<number> {
  return deps.sql.begin(async (tx) => {
    const [row] = await tx<
      Array<{
        subject_user_id: string;
        status: string;
        received_at: Date;
        decided_at: Date | null;
        created_published_at: Date | null;
        confirmed_published_at: Date | null;
      }>
    >`
        SELECT subject_user_id, status, received_at, decided_at, created_published_at, confirmed_published_at
        FROM death_notices WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    // Another run holds it: nothing to do here.
    if (!row) return 0;
    let sent = 0;
    if (!row.created_published_at) {
      await deps.bus.publish(
        'deathNoticeCreated',
        { userId: row.subject_user_id, noticeId: id, at: new Date(row.received_at).toISOString() },
        { idempotencyKey: `identity.death_notice.created:${id}` },
      );
      await tx`UPDATE death_notices SET created_published_at = ${deps.now()} WHERE id = ${id}`;
      sent += 1;
    }
    if (row.status === 'confirmed' && !row.confirmed_published_at && row.decided_at) {
      await deps.bus.publish(
        'deathNoticeConfirmed',
        { userId: row.subject_user_id, noticeId: id, at: new Date(row.decided_at).toISOString() },
        { idempotencyKey: `identity.death_notice.confirmed:${id}` },
      );
      await tx`UPDATE death_notices SET confirmed_published_at = ${deps.now()} WHERE id = ${id}`;
      sent += 1;
    }
    return sent;
  });
}

function signatureValid(publicKey: RecoveryClaimVerifyRequest['signatures'][number]['publicKey'], message: string, signature: string) {
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y }, format: 'jwk' });
    return verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * svc-bank's question before a recovery sweep (RC-identity-08). Read under the account's row lock, so a key revoked or
 * a plan changed before it counts and nothing changes while it answers. Fails closed: the first thing that does not hold
 * is the answer.
 */
export async function verifyRecoveryClaim(sql: Sql, input: RecoveryClaimVerifyRequest): Promise<RecoveryClaimVerdict> {
  const userId = input.userId.toLowerCase();
  const heirUserId = input.heirUserId.toLowerCase();
  const refuse = (code: RecoveryClaimRefusal): RecoveryClaimVerdict => ({ ok: false, code });
  return transaction(sql, async (tx) => {
    const [account] = await tx<Array<{ status: string; version: string }>>`
      SELECT status, identity_control_version::text AS version FROM users WHERE id = ${userId} FOR UPDATE`;
    const [notice] = await tx<Array<{ id: string; frozen_version: string; created_at: Date }>>`
      SELECT id, frozen_control_version::text AS frozen_version, created_at FROM death_notices
      WHERE subject_user_id = ${userId} AND status = 'confirmed'`;
    if (!account || !notice) return refuse('identity.recovery_notice_unconfirmed');
    // Still the freeze the confirmation made: a restore, another freeze or a closure since moves the version on.
    if (account.status !== 'frozen' || account.version !== notice.frozen_version) return refuse('identity.recovery_account_changed');
    const [plan] = await tx<
      Array<{ heir_user_id: string | null; threshold: number | null; heir_status: string | null; changed_after: boolean }>
    >`
      SELECT p.heir_user_id, p.threshold, h.status AS heir_status, p.updated_at >= ${notice.created_at} AS changed_after
        FROM recovery_plans p LEFT JOIN users h ON h.id = p.heir_user_id WHERE p.user_id = ${userId}`;
    if (!plan || plan.threshold === null || plan.threshold < 1) return refuse('identity.recovery_threshold_unset');
    if (!plan.heir_user_id || plan.heir_user_id.toLowerCase() !== heirUserId) return refuse('identity.recovery_heir_mismatch');
    if (plan.heir_status !== 'active') return refuse('identity.recovery_heir_inactive');
    // Only the owner's own setup counts: a heir named, or a key added, once the notice was in may be anyone's doing.
    if (plan.changed_after) return refuse('identity.recovery_changed_after_notice');

    const message = recoveryClaimMessage({ userId, heirUserId, claimId: input.claimId });
    const signers = new Set<string>();
    for (const entry of input.signatures) {
      let fingerprint: string;
      try {
        fingerprint = await fingerprintOf(entry.publicKey);
      } catch {
        return refuse('identity.recovery_signature_invalid');
      }
      const [key] = await tx<Array<{ id: string; revoked_at: Date | null; added_after: boolean }>>`
        SELECT id, revoked_at, created_at >= ${notice.created_at} AS added_after
        FROM recovery_keys WHERE user_id = ${userId} AND public_material_hash = ${fingerprint}`;
      if (!key) return refuse('identity.recovery_key_unknown');
      if (key.revoked_at) return refuse('identity.recovery_key_revoked');
      if (key.added_after) return refuse('identity.recovery_changed_after_notice');
      if (!signatureValid(entry.publicKey, message, entry.signature)) return refuse('identity.recovery_signature_invalid');
      signers.add(key.id);
    }
    if (signers.size < plan.threshold) return refuse('identity.recovery_signatures_short');
    return { ok: true, noticeId: notice.id, threshold: plan.threshold, signerKeyIds: [...signers].sort() };
  });
}

/**
 * The accounts `heirUserId` may claim (RC-identity-08): the owner named them, a death notice is confirmed, the account is
 * still in the freeze that confirmation made, and the plan was set before the notice. The same rules as
 * `verifyRecoveryClaim`, so the claim room never offers an account the check would refuse for those reasons.
 */
export async function listRecoveryEstates(sql: Sql, heirUserId: string): Promise<RecoveryEstate[]> {
  const rows = await sql<Array<{ user_id: string; handle: string; notice_id: string; threshold: number; live_keys: number }>>`
    SELECT u.id AS user_id, u.handle, n.id AS notice_id, p.threshold,
      (SELECT count(*)::int FROM recovery_keys k
        WHERE k.user_id = u.id AND k.revoked_at IS NULL AND k.created_at < n.created_at) AS live_keys
    FROM recovery_plans p
    JOIN users u ON u.id = p.user_id
    JOIN death_notices n ON n.subject_user_id = u.id AND n.status = 'confirmed'
    JOIN users h ON h.id = p.heir_user_id
    WHERE p.heir_user_id = ${heirUserId.toLowerCase()} AND h.status = 'active'
      AND p.threshold IS NOT NULL AND p.updated_at < n.created_at
      AND u.status = 'frozen' AND u.identity_control_version = n.frozen_control_version
    ORDER BY n.decided_at, u.id
    LIMIT 20`;
  return rows.map((r) => ({ userId: r.user_id, handle: r.handle, noticeId: r.notice_id, threshold: r.threshold, liveKeys: r.live_keys }));
}
