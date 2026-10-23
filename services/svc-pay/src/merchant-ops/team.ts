import type { Sql, TransactionSql } from 'postgres';
import { SHUT } from '../owner-pay-grant-recheck.js';
import { MerchantOpsError } from './errors.js';
import { decodeCursor, encodeCursor, requireLimit, toPage, type Page } from './pagination.js';
import { assertPermission, type MerchantCaller, type MerchantRole, type TeamRole } from './roles.js';
import {
  emailInviteToken,
  INVITE_EMAIL_SEPARATOR,
  isReservedTeamUserId,
  normaliseTeamInviteEmail,
  plainTeamLabel,
  readStashedInviteEmail,
  stashInviteEmail,
  teamEventMemberUserId,
  type TeamEmailInviteLimit,
} from './team-email.js';

/**
 * Merchant team: members, roles, invitations, and the append-only trail of who
 * changed whom. The owner is `pay.merchants.user_id` and is listed first.
 *
 * RULES (each names the mistake it prevents)
 *   - Only an interactive session changes the team: no API key, MFA passed, not
 *     a sub-account. A leaked key or a password-only session must not be able to
 *     hand out roles (finance carries payout.approve).
 *   - Only the owner grants, changes or removes `admin`. Otherwise one admin
 *     could remove the others and lock the owner's delegates out.
 *   - Nobody changes their own role (self-promotion).
 *   - The owner is never a row, so "cannot remove the last admin" holds by
 *     construction: the owner is always there.
 *   - An invitation only becomes access when the invited person accepts it.
 *     A confirmed mailbox claim only binds the account onto the invite and
 *     leaves it invited.
 *   - Someone who owns a merchant, or is on another team, cannot JOIN (one
 *     active team per account). That is checked when they accept, never when
 *     they are invited, so an invite reveals nothing about an outside account.
 *   - An email invite stores `email:<address>` and does not look the address
 *     up. The reply is the same whether or not an account already exists.
 *     After a claim, the list still shows that token until accept.
 */

export interface TeamMemberView {
  readonly memberId: string | null;
  readonly userId: string;
  readonly role: MerchantRole;
  readonly status: 'active' | 'invited' | 'removed';
  readonly label: string | null;
  readonly invitedBy: string | null;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly removedAt: string | null;
  readonly cursor: string | null;
}

interface MemberRow {
  id: string;
  user_id: string;
  role: TeamRole;
  status: 'active' | 'invited' | 'removed';
  label: string | null;
  invited_by: string;
  created_at: Date;
  activated_at: Date | null;
  removed_at: Date | null;
  cursor_ts: string;
}

const view = (r: MemberRow): TeamMemberView => {
  const stashed = readStashedInviteEmail(r.label);
  return {
    memberId: r.id,
    userId: stashed && r.status !== 'active' ? stashed.token : r.user_id,
    role: r.role,
    status: r.status,
    label: stashed ? stashed.label : r.label,
    invitedBy: r.invited_by,
    createdAt: r.created_at.toISOString(),
    activatedAt: r.activated_at?.toISOString() ?? null,
    removedAt: r.removed_at?.toISOString() ?? null,
    cursor: encodeCursor(r.cursor_ts, r.id),
  };
};

const MEMBER_FIELDS = (sql: Sql | TransactionSql) => sql`
  m.id, m.user_id, m.role, m.status, m.label, m.invited_by, m.created_at, m.activated_at, m.removed_at,
  to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

export interface TeamEventView {
  readonly seq: string;
  readonly memberUserId: string;
  readonly action: string;
  readonly fromRole: string | null;
  readonly toRole: string | null;
  readonly actorId: string;
  readonly createdAt: string;
}

export class TeamService {
  constructor(
    private readonly sql: Sql,
    private readonly emailInviteLimit?: TeamEmailInviteLimit,
  ) {}

  async list(
    caller: MerchantCaller,
    input: {
      limit?: number | undefined;
      cursor?: string;
      status?: 'active' | 'invited' | 'removed';
      role?: MerchantRole;
      search?: string;
    },
  ) {
    assertPermission(caller, 'team.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    const rows = await sql<MemberRow[]>`
      SELECT ${MEMBER_FIELDS(sql)}
        FROM pay.merchant_team_members m
       WHERE m.merchant_id = ${caller.merchantId}
         ${input.status ? sql`AND m.status = ${input.status}` : sql``}
         ${input.role && input.role !== 'owner' ? sql`AND m.role = ${input.role}` : sql``}
         ${input.role === 'owner' ? sql`AND false` : sql``}
         ${
           input.search
             ? sql`AND (
                 (
                   CASE
                     WHEN m.status <> 'active' AND strpos(coalesce(m.label, ''), ${INVITE_EMAIL_SEPARATOR}) > 0
                       THEN split_part(m.label, ${INVITE_EMAIL_SEPARATOR}, 2)
                     ELSE m.user_id
                   END
                 ) = ${input.search}
                 OR starts_with(
                   lower(split_part(coalesce(m.label, ''), ${INVITE_EMAIL_SEPARATOR}, 1)),
                   lower(${input.search})
                 )
               )`
             : sql``
         }
         ${after ? sql`AND (m.created_at, m.id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${limit + 1}`;
    const page = toPage(rows, limit, view, (r) => encodeCursor(r.cursor_ts, r.id));
    const ownerMatches =
      (input.role === undefined || input.role === 'owner') &&
      (input.status === undefined || input.status === 'active') &&
      input.cursor === undefined;
    if (ownerMatches) {
      const owner = await sql<Array<{ user_id: string; created_at: Date }>>`
        SELECT user_id, created_at FROM pay.merchants WHERE id = ${caller.merchantId}`;
      if (input.search && owner[0]!.user_id !== input.search) return page;
      page.items.unshift({
        memberId: null,
        userId: owner[0]!.user_id,
        role: 'owner',
        status: 'active',
        label: null,
        invitedBy: null,
        createdAt: owner[0]!.created_at.toISOString(),
        activatedAt: owner[0]!.created_at.toISOString(),
        removedAt: null,
        cursor: null,
      });
    }
    return page;
  }

  async history(caller: MerchantCaller, input: { limit?: number | undefined; cursor?: string }): Promise<Page<TeamEventView>> {
    assertPermission(caller, 'team.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    type Row = {
      seq_text: string;
      member_user_id: string;
      action: string;
      from_role: string | null;
      to_role: string | null;
      actor_id: string;
      created_at: Date;
    };
    const rows = await sql<Row[]>`
      SELECT seq::text AS seq_text, member_user_id, action, from_role, to_role, actor_id, created_at
        FROM pay.merchant_team_events
       WHERE merchant_id = ${caller.merchantId}
         ${after ? sql`AND seq < ${after.key}::bigint` : sql``}
       ORDER BY seq DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (r) => ({
        seq: r.seq_text,
        memberUserId: r.member_user_id,
        action: r.action,
        fromRole: r.from_role,
        toRole: r.to_role,
        actorId: r.actor_id,
        createdAt: r.created_at.toISOString(),
      }),
      (r) => encodeCursor('1970-01-01T00:00:00.000000Z', r.seq_text),
    );
  }

  /** Pending invitations addressed to the calling account. Reveals the merchant id only. */
  async myInvitations(userId: string) {
    const rows = await this.sql<Array<{ id: string; merchant_id: string; role: TeamRole; created_at: Date }>>`
      SELECT id, merchant_id, role, created_at FROM pay.merchant_team_members
       WHERE user_id = ${userId} AND status = 'invited' ORDER BY created_at DESC, id DESC`;
    return rows.map((r) => ({ memberId: r.id, merchantId: r.merchant_id, role: r.role, invitedAt: r.created_at.toISOString() }));
  }

  async invite(
    caller: MerchantCaller,
    input: { userId?: string; email?: string; role: TeamRole; label?: string },
  ): Promise<TeamMemberView> {
    this.assertManage(caller, input.role);
    const userId = input.userId?.trim() ?? '';
    const emailRaw = input.email?.trim() ?? '';
    if ((userId === '') === (emailRaw === '')) throw new MerchantOpsError('pay.team_invite_target_invalid', 'bad_request');
    if (emailRaw) return this.inviteByEmail(caller, emailRaw, input.role, input.label);
    if (isReservedTeamUserId(userId)) throw new MerchantOpsError('pay.team_user_id_reserved', 'bad_request');
    return this.sql.begin(async (tx) => {
      // One writer per merchant at a time, so two admins cannot race an invite and a role change.
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      // Whether the invited account owns a merchant or sits on ANOTHER team is not
      // checked here: answering differently would tell one merchant something about
      // an account outside it. acceptInvite enforces one-team-per-account instead.
      const unavailable = new MerchantOpsError('pay.team_member_unavailable', 'conflict');
      const existing = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM pay.merchant_team_members WHERE merchant_id = ${caller.merchantId} AND user_id = ${userId} FOR UPDATE`;
      let id: string;
      const label = plainTeamLabel(input.label);
      if (existing[0]) {
        if (existing[0].status !== 'removed') throw unavailable;
        id = existing[0].id;
        await tx`
          UPDATE pay.merchant_team_members
             SET status = 'invited', role = ${input.role}, label = ${label}, invited_by = ${caller.userId},
                 removed_at = NULL, activated_at = NULL, updated_at = now()
           WHERE id = ${id}`;
      } else {
        const inserted = await tx<Array<{ id: string }>>`
          INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, label, invited_by)
          VALUES (${caller.merchantId}, ${userId}, ${input.role}, 'invited', ${label}, ${caller.userId})
          RETURNING id`;
        id = inserted[0]!.id;
      }
      await tx`
        INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, to_role, actor_id)
        VALUES (${caller.merchantId}, ${userId}, 'invited', ${input.role}, ${caller.userId})`;
      return this.memberView(tx, caller.merchantId, id);
    });
  }

  /**
   * Invite by mailbox. Never reads an account table, so two addresses — one
   * registered, one not — take the same path and return the same shape.
   * The rate window is counted on new invite events only.
   */
  private async inviteByEmail(caller: MerchantCaller, rawEmail: string, role: TeamRole, label?: string): Promise<TeamMemberView> {
    const email = normaliseTeamInviteEmail(rawEmail);
    if (!email) throw new MerchantOpsError('pay.team_email_invalid', 'bad_request');
    this.assertEmailInviteConfigured();
    const token = emailInviteToken(email);
    const visibleLabel = plainTeamLabel(label);
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      const existing = await tx<Array<{ id: string; status: string; user_id: string }>>`
        SELECT id, status, user_id FROM pay.merchant_team_members
         WHERE merchant_id = ${caller.merchantId}
           AND (
             user_id = ${token}
             OR (
               status = 'invited'
               AND split_part(coalesce(label, ''), ${INVITE_EMAIL_SEPARATOR}, 2) = ${token}
             )
           )
         FOR UPDATE`;
      const tokenRow = existing.find((row) => row.user_id === token);
      const bound = existing.find((row) => row.user_id !== token && row.status === 'invited');
      if (tokenRow?.status === 'invited') {
        await tx`
          UPDATE pay.merchant_team_members
             SET role = ${role}, label = ${visibleLabel}, invited_by = ${caller.userId}, updated_at = now()
           WHERE id = ${tokenRow.id}`;
        return this.memberView(tx, caller.merchantId, tokenRow.id);
      }
      // Already bound and still invited: refresh the role, keep the account id internal.
      if (bound) {
        await tx`
          UPDATE pay.merchant_team_members
             SET role = ${role}, label = ${stashInviteEmail(visibleLabel, token)}, invited_by = ${caller.userId}, updated_at = now()
           WHERE id = ${bound.id}`;
        return this.memberView(tx, caller.merchantId, bound.id);
      }
      await this.assertEmailInviteBudget(tx, caller.merchantId);
      let id: string;
      if (tokenRow) {
        id = tokenRow.id;
        await tx`
          UPDATE pay.merchant_team_members
             SET status = 'invited', role = ${role}, label = ${visibleLabel}, invited_by = ${caller.userId},
                 removed_at = NULL, activated_at = NULL, updated_at = now()
           WHERE id = ${id}`;
      } else {
        const inserted = await tx<Array<{ id: string }>>`
          INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, label, invited_by)
          VALUES (${caller.merchantId}, ${token}, ${role}, 'invited', ${visibleLabel}, ${caller.userId})
          RETURNING id`;
        id = inserted[0]!.id;
      }
      await tx`
        INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, to_role, actor_id)
        VALUES (${caller.merchantId}, ${token}, 'invited', ${role}, ${caller.userId})`;
      return this.memberView(tx, caller.merchantId, id);
    });
  }

  private assertEmailInviteConfigured(): void {
    const limit = this.emailInviteLimit;
    if (
      !limit ||
      !Number.isInteger(limit.maxPerWindow) ||
      limit.maxPerWindow < 1 ||
      !Number.isInteger(limit.windowMs) ||
      limit.windowMs < 1 ||
      !Number.isInteger(limit.ttlMs) ||
      limit.ttlMs < 1
    ) {
      throw new MerchantOpsError('pay.team_email_invite_unconfigured', 'precondition');
    }
  }

  private async assertEmailInviteBudget(tx: TransactionSql, merchantId: string): Promise<void> {
    const limit = this.emailInviteLimit;
    if (!limit) throw new MerchantOpsError('pay.team_email_invite_unconfigured', 'precondition');
    const windowStart = new Date(Date.now() - limit.windowMs);
    const counted = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_team_events
       WHERE merchant_id = ${merchantId} AND action = 'invited'
         AND member_user_id LIKE 'email:%' AND created_at >= ${windowStart}`;
    if ((counted[0]?.n ?? 0) >= limit.maxPerWindow) {
      throw new MerchantOpsError('pay.team_email_invite_rate_limited', 'precondition');
    }
  }

  async changeRole(caller: MerchantCaller, input: { memberId: string; role: TeamRole }): Promise<TeamMemberView> {
    this.assertManage(caller, input.role);
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      const target = await this.lockMember(tx, caller.merchantId, input.memberId);
      if (target.status === 'removed') throw new MerchantOpsError('pay.team_member_not_found', 'not_found');
      if (target.user_id === caller.userId) throw new MerchantOpsError('pay.team_self_change_forbidden', 'forbidden');
      if (target.role === 'admin' && caller.role !== 'owner') throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
      if (target.role !== input.role) {
        await tx`UPDATE pay.merchant_team_members SET role = ${input.role}, updated_at = now() WHERE id = ${target.id}`;
        const shown = teamEventMemberUserId(target.user_id, target.label, target.status);
        await tx`
          INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, from_role, to_role, actor_id)
          VALUES (${caller.merchantId}, ${shown}, 'role_changed', ${target.role}, ${input.role}, ${caller.userId})`;
      }
      return this.memberView(tx, caller.merchantId, target.id);
    });
  }

  async remove(caller: MerchantCaller, input: { memberId: string }): Promise<TeamMemberView> {
    if (!caller.interactive) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
    assertPermission(caller, 'team.manage');
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      const target = await this.lockMember(tx, caller.merchantId, input.memberId);
      if (target.status === 'removed') throw new MerchantOpsError('pay.team_member_not_found', 'not_found');
      if (target.user_id === caller.userId) throw new MerchantOpsError('pay.team_self_change_forbidden', 'forbidden');
      if (target.role === 'admin' && caller.role !== 'owner') throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
      await this.markRemoved(tx, caller.merchantId, target, caller.userId);
      return this.memberView(tx, caller.merchantId, target.id);
    });
  }

  /** A member leaves their own team. No `team.manage` needed: it is their own access. */
  async leave(caller: MerchantCaller): Promise<{ left: true }> {
    if (!caller.interactive) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
    if (caller.role === 'owner') throw new MerchantOpsError('pay.team_owner_cannot_leave', 'forbidden');
    await this.sql.begin(async (tx) => {
      const rows = await tx<Array<{ id: string; user_id: string; role: TeamRole; status: string }>>`
        SELECT id, user_id, role, status FROM pay.merchant_team_members
         WHERE merchant_id = ${caller.merchantId} AND user_id = ${caller.userId} AND status = 'active' FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new MerchantOpsError('pay.team_member_not_found', 'not_found');
      await this.markRemoved(tx, caller.merchantId, row, caller.userId);
    });
    return { left: true };
  }

  /** The invited account accepts. This is the only way an invitation becomes access. */
  async acceptInvite(userId: string, memberId: string): Promise<TeamMemberView> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        Array<{ id: string; merchant_id: string; user_id: string; role: TeamRole; status: string; label: string | null }>
      >`
        SELECT id, merchant_id, user_id, role, status, label FROM pay.merchant_team_members WHERE id = ${memberId}::uuid AND user_id = ${userId} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.status !== 'invited') throw new MerchantOpsError('pay.team_invitation_not_found', 'not_found');
      const owns = await tx`SELECT 1 FROM pay.merchants WHERE user_id = ${userId} LIMIT 1`;
      const busy = await tx`SELECT 1 FROM pay.merchant_team_members WHERE user_id = ${userId} AND status = 'active' LIMIT 1`;
      if (owns[0] || busy[0]) throw new MerchantOpsError('pay.team_member_unavailable', 'conflict');
      // Joining a suspended or closed business would withdraw the person's own onboarding grant until they leave.
      // FOR SHARE orders this check against a suspension committing at the same time.
      const business = await tx<
        Array<{ status: string }>
      >`SELECT status::text AS status FROM pay.merchants WHERE id = ${row.merchant_id} FOR SHARE`;
      if ((SHUT as ReadonlySet<string>).has(business[0]?.status ?? ''))
        throw new MerchantOpsError('pay.team_business_shut', 'precondition');
      const stashed = readStashedInviteEmail(row.label);
      const label = stashed ? stashed.label : row.label;
      try {
        await tx`
          UPDATE pay.merchant_team_members
             SET status = 'active', activated_at = now(), label = ${label}, updated_at = now()
           WHERE id = ${row.id}`;
      } catch (error) {
        // Two invitations accepted at once: the one-active-team index decides, and the loser gets the same answer as above.
        if ((error as { code?: string }).code === '23505') throw new MerchantOpsError('pay.team_member_unavailable', 'conflict');
        throw error;
      }
      await tx`
        INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, to_role, actor_id)
        VALUES (${row.merchant_id}, ${userId}, 'accepted', ${row.role}, ${userId})`;
      return this.memberView(tx, row.merchant_id, row.id);
    });
  }

  async declineInvite(userId: string, memberId: string): Promise<{ declined: true }> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        Array<{ id: string; merchant_id: string; user_id: string; role: TeamRole; status: string; label: string | null }>
      >`
        SELECT id, merchant_id, user_id, role, status, label FROM pay.merchant_team_members WHERE id = ${memberId}::uuid AND user_id = ${userId} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.status !== 'invited') throw new MerchantOpsError('pay.team_invitation_not_found', 'not_found');
      await tx`UPDATE pay.merchant_team_members SET status = 'removed', removed_at = now(), updated_at = now() WHERE id = ${row.id}`;
      const shown = teamEventMemberUserId(row.user_id, row.label, row.status);
      await tx`
        INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, from_role, actor_id)
        VALUES (${row.merchant_id}, ${shown}, 'declined', ${row.role}, ${shown})`;
    });
    return { declined: true };
  }

  private assertManage(caller: MerchantCaller, grantedRole: TeamRole): void {
    if (!caller.interactive) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
    assertPermission(caller, 'team.manage');
    if (grantedRole === 'admin' && caller.role !== 'owner') throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
  }

  private async lockMember(tx: TransactionSql, merchantId: string, memberId: string) {
    // Merchant-scoped lookup: another merchant's member id is simply not found.
    const rows = await tx<
      Array<{ id: string; user_id: string; role: TeamRole; status: 'active' | 'invited' | 'removed'; label: string | null }>
    >`
      SELECT id, user_id, role, status, label FROM pay.merchant_team_members WHERE id = ${memberId}::uuid AND merchant_id = ${merchantId} FOR UPDATE`;
    if (!rows[0]) throw new MerchantOpsError('pay.team_member_not_found', 'not_found');
    return rows[0];
  }

  private async markRemoved(
    tx: TransactionSql,
    merchantId: string,
    target: { id: string; user_id: string; role: TeamRole; label?: string | null; status?: string },
    actorId: string,
  ) {
    await tx`UPDATE pay.merchant_team_members SET status = 'removed', removed_at = now(), updated_at = now() WHERE id = ${target.id}`;
    const shown = teamEventMemberUserId(target.user_id, target.label ?? null, target.status ?? 'active');
    await tx`
      INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, from_role, actor_id)
      VALUES (${merchantId}, ${shown}, 'removed', ${target.role}, ${actorId})`;
  }

  private async memberView(sql: Sql | TransactionSql, merchantId: string, id: string): Promise<TeamMemberView> {
    const rows = await sql<MemberRow[]>`
      SELECT ${MEMBER_FIELDS(sql)} FROM pay.merchant_team_members m WHERE m.id = ${id} AND m.merchant_id = ${merchantId}`;
    return view(rows[0]!);
  }
}
