/**
 * Bind pending email invites to the confirmed account identity names.
 *
 * Called by svc-identity over service HMAC, not by a merchant session.
 * Identity only calls this after `email_verified_at` is set, and sends the
 * stored mailbox. A missing published lifetime binds nothing. An invite
 * older than that lifetime stays pending. One active team still applies:
 * a person who already owns a merchant, or already sits on a team, is bound
 * but left invited. The next explicit accept then returns the same conflict
 * as any other invitation.
 *
 * Lock order matches `TeamService.invite`: merchant row first, then member
 * rows. Claim never holds a member lock while waiting for a merchant lock.
 */
import type { Sql, TransactionSql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import { emailInviteToken, normaliseTeamInviteEmail, publishedTeamEmailInviteTtlMs } from './team-email.js';
import type { TeamRole } from './roles.js';

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EmailInviteClaimResult {
  readonly claimed: number;
  readonly accepted: number;
}

interface PendingRow {
  id: string;
  merchant_id: string;
  role: TeamRole;
  label: string | null;
  invited_by: string;
}

export async function claimEmailTeamInvites(
  sql: Sql,
  input: { userId: string; email: string },
  ttlMs: number | undefined,
): Promise<EmailInviteClaimResult> {
  const email = normaliseTeamInviteEmail(input.email);
  const userId = input.userId.trim();
  if (!email || !USER_ID.test(userId)) throw new MerchantOpsError('pay.team_email_invalid', 'bad_request');
  const ttl = publishedTeamEmailInviteTtlMs(ttlMs);
  if (ttl === undefined) return { claimed: 0, accepted: 0 };
  const token = emailInviteToken(email);

  return sql.begin(async (tx) => {
    const preview = await tx<Array<{ merchant_id: string }>>`
      SELECT merchant_id FROM pay.merchant_team_members
       WHERE user_id = ${token} AND status = 'invited'
         AND updated_at >= now() - (${ttl} * interval '1 millisecond')`;
    const merchantIds = [...new Set(preview.map((row) => row.merchant_id))].sort();
    for (const merchantId of merchantIds) {
      await tx`SELECT id FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE`;
    }
    const pending = await tx<PendingRow[]>`
      SELECT id, merchant_id, role, label, invited_by
        FROM pay.merchant_team_members
       WHERE user_id = ${token} AND status = 'invited'
         AND updated_at >= now() - (${ttl} * interval '1 millisecond')
       ORDER BY id
       FOR UPDATE`;
    let claimed = 0;
    let accepted = 0;
    for (const row of pending) {
      const did = await bindOne(tx, row, userId, token);
      claimed += 1;
      if (did) accepted += 1;
    }
    return { claimed, accepted };
  });
}

async function bindOne(tx: TransactionSql, row: PendingRow, userId: string, token: string): Promise<boolean> {
  const existing = await tx<Array<{ id: string; status: string }>>`
    SELECT id, status FROM pay.merchant_team_members
     WHERE merchant_id = ${row.merchant_id} AND user_id = ${userId}
     FOR UPDATE`;
  if (existing[0]) {
    await tx`
      UPDATE pay.merchant_team_members
         SET status = 'removed', removed_at = now(), updated_at = now()
       WHERE id = ${row.id}`;
    await tx`
      INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, from_role, actor_id)
      VALUES (${row.merchant_id}, ${token}, 'removed', ${row.role}, ${userId})`;
    if (existing[0].status !== 'removed') return false;
    await tx`
      UPDATE pay.merchant_team_members
         SET status = 'invited', role = ${row.role}, label = ${row.label}, invited_by = ${row.invited_by},
             removed_at = NULL, activated_at = NULL, updated_at = now()
       WHERE id = ${existing[0].id}`;
    return tryAccept(tx, userId, existing[0].id, row.merchant_id, row.role);
  }
  await tx`
    UPDATE pay.merchant_team_members
       SET user_id = ${userId}, updated_at = now()
     WHERE id = ${row.id}`;
  return tryAccept(tx, userId, row.id, row.merchant_id, row.role);
}

/** True when the invitation became access. A conflict leaves it invited. */
async function tryAccept(tx: TransactionSql, userId: string, memberId: string, merchantId: string, role: TeamRole): Promise<boolean> {
  const owns = await tx`SELECT 1 FROM pay.merchants WHERE user_id = ${userId} LIMIT 1`;
  const busy = await tx`
    SELECT 1 FROM pay.merchant_team_members
     WHERE user_id = ${userId} AND status = 'active' AND id <> ${memberId}
     LIMIT 1`;
  if (owns[0] || busy[0]) return false;
  try {
    const updated = await tx<Array<{ id: string }>>`
      UPDATE pay.merchant_team_members
         SET status = 'active', activated_at = now(), updated_at = now()
       WHERE id = ${memberId} AND status = 'invited'
       RETURNING id`;
    if (!updated[0]) return false;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }
  await tx`
    INSERT INTO pay.merchant_team_events (merchant_id, member_user_id, action, to_role, actor_id)
    VALUES (${merchantId}, ${userId}, 'accepted', ${role}, ${userId})`;
  return true;
}
