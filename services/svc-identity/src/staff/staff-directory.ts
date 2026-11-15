/**
 * The staff directory (OPS-admin-access-03, J-ops-console-09 #2).
 *
 * A founder invites one named person by email and name. The invite is a privileged staff change
 * (`identity.staff.invite`, a governed type): one founder asks, a different person in the policy's audience approves the
 * exact invite, and identity spends that approval once in the same transaction that writes the invite. While the type's
 * policy row is unset the propose, the approve and this apply all refuse `action_approval.policy_unset`.
 *
 * The invited person gets a one-time link by mail. Opening it they set their own password: that makes their identity
 * account with the invited email (already confirmed, since the token reached that mailbox), spends the token, and turns
 * the staff record active, all in one transaction. Only the token's SHA-256 is stored. The invite's life is an owner
 * value (`IDENTITY_STAFF_INVITE_TTL_SECONDS`); while blank, inviting refuses `identity.staff_invite_ttl_unset`.
 *
 * An email that already has an identity account is refused `auth.email_taken` for now: binding an existing account to
 * a staff record is a later change. Nothing here is money.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  IDENTITY_STAFF_INVITE_INVALID,
  IDENTITY_STAFF_INVITE_TTL_UNSET,
  readStaffInvite,
  staffChangeApprovalSubject,
  staffChangePayloadText,
  type StaffEntry,
  type StaffInvitation,
  type StaffInviteInput,
} from '@intafaced/contracts/identity-staff';
import { ActionApprovalError, type ActionApprovalService } from '../auth/action-approval-service.js';
import type { PasswordResetMail } from '../auth/password-reset.js';

export class StaffDirectoryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'StaffDirectoryError';
  }
}

type StaffRow = {
  id: string;
  email: string;
  display_name: string;
  user_id: string | null;
  status: 'invited' | 'active' | 'disabled';
  role_ids: string[];
  invited_by: string;
  invited_at: Date;
  activated_at: Date | null;
  disabled_at: Date | null;
  last_sign_in_at: Date | null;
  version: number;
};

const STAFF_COLUMNS = `id, email::text AS email, display_name, user_id, status, role_ids, invited_by, invited_at, activated_at,
  disabled_at, last_sign_in_at, version`;

export function staffEntryOf(row: StaffRow): StaffEntry {
  return {
    staffId: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    roleIds: [...row.role_ids],
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    invitedAt: row.invited_at.toISOString(),
    invitedBy: row.invited_by,
    activatedAt: row.activated_at?.toISOString() ?? null,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    version: String(row.version),
  };
}

export const tokenHashOf = (token: string): string => createHash('sha256').update(token).digest('hex');
export const staffPayloadHash = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export interface StaffDirectoryDeps {
  readonly sql: Sql;
  readonly approvals: Pick<ActionApprovalService, 'consume'>;
  readonly mail: PasswordResetMail | undefined;
  readonly inviteTtlSeconds: number | undefined;
  /** Makes the invited person's account and runs `claim` in the same transaction (`AuthService.registerInvitedStaff`). */
  readonly registerAccount: (
    input: { email: string; password: string; deviceKey?: string | null },
    claim: (tx: Sql, userId: string) => Promise<void>,
  ) => Promise<string>;
  readonly clock?: () => Date;
}

export class StaffDirectory {
  constructor(private readonly deps: StaffDirectoryDeps) {}

  private now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }

  async list(): Promise<{ staff: StaffEntry[]; nextCursor: null; asOf: string }> {
    const rows = await this.deps.sql.unsafe<StaffRow[]>(`SELECT ${STAFF_COLUMNS} FROM staff_members ORDER BY invited_at, id LIMIT 200`);
    return { staff: rows.map(staffEntryOf), nextCursor: null, asOf: this.now().toISOString() };
  }

  /**
   * Invite one named person, spending the approval a second person gave for exactly this invite. The mail with the
   * one-time link is sent after the invite commits; a failed send leaves the invite and says so.
   */
  async invite(actorId: string, raw: unknown): Promise<{ staff: StaffEntry; mailed: boolean; approverId: string; auditId: string }> {
    const read = readStaffInvite(raw);
    if (!read.ok) {
      if ('code' in read) throw new StaffDirectoryError('an invite names one person by email and name', read.code);
      throw new StaffDirectoryError(read.error.issues[0]?.message ?? 'the invite is not valid', 'identity.staff_invite_invalid_input');
    }
    const input: StaffInviteInput = read.input;
    const ttl = this.deps.inviteTtlSeconds;
    if (ttl === undefined) throw new StaffDirectoryError('the owner has not set how long an invite lasts', IDENTITY_STAFF_INVITE_TTL_UNSET);
    if (input.roleIds.length > 0) {
      // Roles are granted with their own change (`identity.roles.assign`) once roles exist; an invite names none yet.
      throw new StaffDirectoryError('roles are given after the person joins', 'identity.staff_permission_invalid');
    }
    const subject = staffChangeApprovalSubject('identity.staff.invite', input);
    const payloadHash = staffPayloadHash(staffChangePayloadText(subject));
    if (input.approval.payloadHash !== payloadHash) {
      throw new StaffDirectoryError('the approval is for a different invite than this one', 'action_approval.payload_mismatch');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    const { sql } = this.deps;

    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`identity.staff_invite:${input.email}`}))`;
      const [replay] = await tx.unsafe<StaffRow[]>(`SELECT ${STAFF_COLUMNS} FROM staff_members WHERE request_id = $1`, [input.requestId]);
      if (replay) return { replayed: true as const, row: replay };
      const [account] = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${input.email}`;
      if (account) throw new StaffDirectoryError('An account with that email already exists', 'auth.email_taken');
      const [already] = await tx<Array<{ id: string }>>`SELECT id FROM staff_members WHERE email = ${input.email}`;
      if (already) throw new StaffDirectoryError('that person is already invited', 'identity.staff_already_invited');
      let approved;
      try {
        approved = await this.deps.approvals.consume('svc-identity', {
          approvalId: input.approval.approvalId,
          operationId: input.approval.operationId,
          payloadHash,
          targetService: subject.targetService,
          targetId: subject.targetId,
          expectedVersion: '1',
        });
      } catch (err) {
        if (err instanceof ActionApprovalError) throw new StaffDirectoryError(err.message, err.code);
        throw err;
      }
      if (approved.actionType !== 'identity.staff.invite') {
        throw new StaffDirectoryError('the approval is for a different kind of change', 'action_approval.target_mismatch');
      }
      const approverId = approved.approverId ?? approved.requesterId;
      const [row] = await tx.unsafe<StaffRow[]>(
        `INSERT INTO staff_members (email, display_name, invited_by, approved_by, approval_id, request_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${STAFF_COLUMNS}`,
        [input.email, input.displayName, actorId, approverId, input.approval.approvalId, input.requestId],
      );
      await tx`INSERT INTO staff_invite_tokens (token_hash, staff_id, expires_at) VALUES (${tokenHashOf(token)}, ${row!.id}, ${expiresAt})`;
      const [audit] = await tx<Array<{ audit_id: string }>>`
        INSERT INTO staff_change_audit (request_id, action, actor_id, approver_id, approval_id, staff_id, detail)
        VALUES (${input.requestId}, 'identity.staff.invite', ${actorId}, ${approverId}, ${input.approval.approvalId}, ${row!.id},
          ${tx.json({ email: input.email, displayName: input.displayName })})
        RETURNING audit_id`;
      return { replayed: false as const, row: row!, approverId, auditId: audit!.audit_id };
    });

    if (result.replayed) {
      const [audit] = await sql<Array<{ audit_id: string; approver_id: string }>>`
        SELECT audit_id, approver_id FROM staff_change_audit WHERE request_id = ${input.requestId} AND action = 'identity.staff.invite'`;
      return { staff: staffEntryOf(result.row), mailed: false, approverId: audit?.approver_id ?? '', auditId: audit?.audit_id ?? '' };
    }
    let mailed = false;
    if (this.deps.mail) {
      try {
        await this.deps.mail.send({ email: input.email, code: token, expiresAt, purpose: 'staff-invite' });
        mailed = true;
      } catch {
        mailed = false;
      }
    }
    return { staff: staffEntryOf(result.row), mailed, approverId: result.approverId, auditId: result.auditId };
  }

  private async openToken(q: Sql, token: string, lock: boolean): Promise<{ staff: StaffRow; expiresAt: Date } | null> {
    const hash = tokenHashOf(token);
    const rows = await q<Array<{ token_hash: string; staff_id: string; expires_at: Date; used_at: Date | null }>>`
      SELECT token_hash, staff_id, expires_at, used_at FROM staff_invite_tokens WHERE token_hash = ${hash}
      ${lock ? q`FOR UPDATE` : q``}`;
    const t = rows[0];
    if (!t || !timingSafeEqual(Buffer.from(t.token_hash), Buffer.from(hash))) return null;
    if (t.used_at !== null || t.expires_at.getTime() <= this.now().getTime()) return null;
    const [staff] = await q.unsafe<StaffRow[]>(`SELECT ${STAFF_COLUMNS} FROM staff_members WHERE id = $1`, [t.staff_id]);
    if (!staff || staff.status !== 'invited') return null;
    return { staff, expiresAt: t.expires_at };
  }

  /** Who a first-connection link is for. Unknown, used and expired links answer the same. */
  async invitation(token: string): Promise<StaffInvitation> {
    const open = await this.openToken(this.deps.sql, token, false);
    if (!open) return { state: 'invalid', code: IDENTITY_STAFF_INVITE_INVALID };
    return { state: 'open', email: open.staff.email, displayName: open.staff.display_name, expiresAt: open.expiresAt.toISOString() };
  }

  /** The invited person sets their own password: their account is made, the token spent and the record active, at once. */
  async accept(token: string, password: string, deviceKey?: string | null): Promise<StaffEntry> {
    const peek = await this.openToken(this.deps.sql, token, false);
    if (!peek) throw new StaffDirectoryError('This invite link is not valid any more', IDENTITY_STAFF_INVITE_INVALID);
    let activated: StaffRow | undefined;
    await this.deps.registerAccount({ email: peek.staff.email, password, deviceKey }, async (tx, userId) => {
      const open = await this.openToken(tx, token, true);
      if (!open || open.staff.id !== peek.staff.id)
        throw new StaffDirectoryError('This invite link is not valid any more', IDENTITY_STAFF_INVITE_INVALID);
      await tx`UPDATE staff_invite_tokens SET used_at = now() WHERE token_hash = ${tokenHashOf(token)}`;
      [activated] = await tx.unsafe<StaffRow[]>(
        `UPDATE staff_members SET user_id = $1, status = 'active', activated_at = now(), version = version + 1
         WHERE id = $2 AND status = 'invited' RETURNING ${STAFF_COLUMNS}`,
        [userId, open.staff.id],
      );
      if (!activated) throw new StaffDirectoryError('This invite link is not valid any more', IDENTITY_STAFF_INVITE_INVALID);
      await tx`
        INSERT INTO staff_change_audit (request_id, action, actor_id, staff_id, detail)
        VALUES (${`first-connection:${open.staff.id}`}, 'identity.staff.first_connection', ${userId}, ${open.staff.id}, '{}'::jsonb)`;
    });
    return staffEntryOf(activated!);
  }
}
